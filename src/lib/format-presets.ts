// Formatting presets — the source of truth for per-document styling.
// Each preset drives both the on-screen editor (via CSS custom props on
// `.legal-prose`) and the exported DOCX (font, size, line spacing, margins,
// optional caption block). No backend, no schema — presets are pure config.

export type PresetId =
  | 'federal-motion'
  | 'federal-brief'
  | 'letter'
  | 'internal-memo'
  | 'discovery'
  | 'stipulation'
  | 'outline'
  | 'bench-memo';

export type HeadingScale = 'legal' | 'memo' | 'letter';

export type DocxPresetSpec = {
  font: 'Times New Roman' | 'Century Schoolbook' | 'Arial' | 'Calibri';
  sizeHalfPts: number; // 24 = 12pt
  lineTwips: number; // 480 = double, 360 = 1.5×, 276 = 1.15×
  firstLineIndentDxa: number; // 720 = 0.5"
  marginsDxa: { top: number; right: number; bottom: number; left: number };
  justify: boolean;
  numberedHeadings: 'roman' | 'decimal' | 'none';
  captionLine?: string; // short label rendered at top when set
};

export type EditorPresetSpec = {
  fontFamily: string; // css value
  fontSize: string; // css value
  lineHeight: string;
  firstLineIndent: string; // '0' or '2em'
  headingScale: HeadingScale;
  justify: boolean;
};

export type FormatPreset = {
  id: PresetId;
  label: string;
  short: string; // one-line summary shown in launcher
  editor: EditorPresetSpec;
  docx: DocxPresetSpec;
};

const IN = 1440; // twips per inch
const ONE_INCH = { top: IN, right: IN, bottom: IN, left: IN };

const SERIF = "'Source Serif 4', Georgia, 'Times New Roman', serif";
const SANS = "'Inter', system-ui, -apple-system, sans-serif";

export const FORMAT_PRESETS: FormatPreset[] = [
  {
    id: 'federal-motion',
    label: 'Federal Motion',
    short: 'Times 12 · Double-spaced · Numbered headings',
    editor: {
      fontFamily: SERIF,
      fontSize: '15px',
      lineHeight: '1.9',
      firstLineIndent: '2em',
      headingScale: 'legal',
      justify: true,
    },
    docx: {
      font: 'Times New Roman',
      sizeHalfPts: 24,
      lineTwips: 480,
      firstLineIndentDxa: 720,
      marginsDxa: ONE_INCH,
      justify: true,
      numberedHeadings: 'roman',
      captionLine: 'UNITED STATES DISTRICT COURT',
    },
  },
  {
    id: 'federal-brief',
    label: 'Federal Brief',
    short: 'Century Schoolbook 12 · Double-spaced',
    editor: {
      fontFamily: "'Source Serif 4', 'Century Schoolbook', Georgia, serif",
      fontSize: '15px',
      lineHeight: '1.9',
      firstLineIndent: '2em',
      headingScale: 'legal',
      justify: true,
    },
    docx: {
      font: 'Century Schoolbook',
      sizeHalfPts: 24,
      lineTwips: 480,
      firstLineIndentDxa: 720,
      marginsDxa: ONE_INCH,
      justify: true,
      numberedHeadings: 'roman',
      captionLine: 'UNITED STATES DISTRICT COURT',
    },
  },
  {
    id: 'letter',
    label: 'Letter',
    short: 'Times 12 · Single-spaced · Block form',
    editor: {
      fontFamily: SERIF,
      fontSize: '14.5px',
      lineHeight: '1.55',
      firstLineIndent: '0',
      headingScale: 'letter',
      justify: false,
    },
    docx: {
      font: 'Times New Roman',
      sizeHalfPts: 24,
      lineTwips: 276,
      firstLineIndentDxa: 0,
      marginsDxa: ONE_INCH,
      justify: false,
      numberedHeadings: 'none',
    },
  },
  {
    id: 'internal-memo',
    label: 'Internal Memo',
    short: 'Inter 11 · 1.15 · Memo header',
    editor: {
      fontFamily: SANS,
      fontSize: '14px',
      lineHeight: '1.6',
      firstLineIndent: '0',
      headingScale: 'memo',
      justify: false,
    },
    docx: {
      font: 'Calibri',
      sizeHalfPts: 22,
      lineTwips: 276,
      firstLineIndentDxa: 0,
      marginsDxa: ONE_INCH,
      justify: false,
      numberedHeadings: 'decimal',
      captionLine: 'INTERNAL MEMORANDUM',
    },
  },
  {
    id: 'discovery',
    label: 'Discovery Request',
    short: 'Times 12 · Numbered items · Definitions block',
    editor: {
      fontFamily: SERIF,
      fontSize: '14.5px',
      lineHeight: '1.7',
      firstLineIndent: '0',
      headingScale: 'legal',
      justify: false,
    },
    docx: {
      font: 'Times New Roman',
      sizeHalfPts: 24,
      lineTwips: 360,
      firstLineIndentDxa: 0,
      marginsDxa: ONE_INCH,
      justify: false,
      numberedHeadings: 'roman',
      captionLine: 'UNITED STATES DISTRICT COURT',
    },
  },
  {
    id: 'stipulation',
    label: 'Stipulation / Order',
    short: 'Times 12 · Numbered paragraphs · SO ORDERED',
    editor: {
      fontFamily: SERIF,
      fontSize: '14.5px',
      lineHeight: '1.75',
      firstLineIndent: '0',
      headingScale: 'legal',
      justify: true,
    },
    docx: {
      font: 'Times New Roman',
      sizeHalfPts: 24,
      lineTwips: 360,
      firstLineIndentDxa: 0,
      marginsDxa: ONE_INCH,
      justify: true,
      numberedHeadings: 'decimal',
      captionLine: 'UNITED STATES DISTRICT COURT',
    },
  },
  {
    id: 'outline',
    label: 'Outline',
    short: 'Inter 11 · Tight · Nested headings',
    editor: {
      fontFamily: SANS,
      fontSize: '13.5px',
      lineHeight: '1.5',
      firstLineIndent: '0',
      headingScale: 'memo',
      justify: false,
    },
    docx: {
      font: 'Calibri',
      sizeHalfPts: 22,
      lineTwips: 276,
      firstLineIndentDxa: 0,
      marginsDxa: { top: IN, right: IN, bottom: IN, left: IN },
      justify: false,
      numberedHeadings: 'roman',
    },
  },
  {
    id: 'bench-memo',
    label: 'Bench Memo',
    short: 'Times 12 · 1.5 · Question presented',
    editor: {
      fontFamily: SERIF,
      fontSize: '14.5px',
      lineHeight: '1.75',
      firstLineIndent: '0',
      headingScale: 'legal',
      justify: false,
    },
    docx: {
      font: 'Times New Roman',
      sizeHalfPts: 24,
      lineTwips: 360,
      firstLineIndentDxa: 0,
      marginsDxa: ONE_INCH,
      justify: false,
      numberedHeadings: 'roman',
      captionLine: 'BENCH MEMORANDUM',
    },
  },
];

export const PRESETS_BY_ID: Record<PresetId, FormatPreset> = FORMAT_PRESETS.reduce(
  (acc, p) => {
    acc[p.id] = p;
    return acc;
  },
  {} as Record<PresetId, FormatPreset>,
);

export function getPreset(id: PresetId | null | undefined): FormatPreset {
  if (id && PRESETS_BY_ID[id]) return PRESETS_BY_ID[id];
  return PRESETS_BY_ID['internal-memo'];
}
