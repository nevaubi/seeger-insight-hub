// Minimal ZIP writer (STORED / no compression). Zero dependencies.
//
// OOXML containers (.xlsx, .docx) are ordinary ZIP archives, and the spec permits
// uncompressed ("stored") entries — so a tiny stored-only writer is enough to produce
// genuine Office files in the browser without pulling in a zip library. Used by
// file-export.ts to build Excel and Word documents client-side.

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u16 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
const u32 = (n: number) =>
  new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export type ZipEntry = { name: string; data: Uint8Array };

/** Build a ZIP archive (stored, no compression) from the given entries. */
export function zipSync(entries: ZipEntry[]): Blob {
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;
  const enc = new TextEncoder();
  const UTF8_FLAG = 0x0800; // general-purpose bit 11: filename is UTF-8

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.data);
    const size = e.data.length;

    const local = concat([
      u32(0x04034b50), // local file header signature
      u16(20), // version needed
      u16(UTF8_FLAG), // flags
      u16(0), // method = stored
      u16(0), // mod time
      u16(0x21), // mod date (1980-01-01)
      u32(crc),
      u32(size), // compressed size
      u32(size), // uncompressed size
      u16(nameBytes.length),
      u16(0), // extra length
      nameBytes,
      e.data,
    ]);
    localChunks.push(local);

    centralChunks.push(
      concat([
        u32(0x02014b50), // central directory header signature
        u16(20), // version made by
        u16(20), // version needed
        u16(UTF8_FLAG), // flags
        u16(0), // method
        u16(0), // mod time
        u16(0x21), // mod date
        u32(crc),
        u32(size),
        u32(size),
        u16(nameBytes.length),
        u16(0), // extra length
        u16(0), // comment length
        u16(0), // disk number start
        u16(0), // internal attrs
        u32(0), // external attrs
        u32(offset), // local header offset
        nameBytes,
      ]),
    );
    offset += local.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of centralChunks) centralSize += c.length;

  const eocd = concat([
    u32(0x06054b50), // end of central directory signature
    u16(0), // disk number
    u16(0), // disk with central dir
    u16(entries.length),
    u16(entries.length),
    u32(centralSize),
    u32(centralStart),
    u16(0), // comment length
  ]);

  const all = concat([...localChunks, ...centralChunks, eocd]);
  return new Blob([all as BlobPart], { type: 'application/zip' });
}

export const utf8 = (s: string) => new TextEncoder().encode(s);

/** XML-escape text content / attribute values. */
export function xmlEscape(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
