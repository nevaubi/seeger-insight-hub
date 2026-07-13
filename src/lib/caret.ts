// Textarea selection geometry — the classic hidden-mirror technique. A floating menu
// over a <textarea> needs pixel coordinates for a character range, which textareas don't
// expose; we clone the textarea's text into an off-screen div with identical text metrics
// and measure a <span> wrapped around the selection.

const MIRRORED_PROPS = [
  'boxSizing',
  'width',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
  'lineHeight',
  'textTransform',
  'wordSpacing',
  'textIndent',
  'whiteSpace',
  'wordBreak',
  'overflowWrap',
  'tabSize',
] as const;

export interface SelectionRect {
  /** Top of the selection's first line, in coordinates relative to the textarea's offset box. */
  top: number;
  left: number;
  height: number;
}

export function measureSelection(
  textarea: HTMLTextAreaElement,
  start: number,
  end: number,
): SelectionRect | null {
  if (typeof window === 'undefined') return null;
  const value = textarea.value;
  if (start < 0 || end > value.length || end <= start) return null;

  const mirror = document.createElement('div');
  const style = window.getComputedStyle(textarea);
  const mirrorStyle = mirror.style as unknown as Record<string, string>;
  const sourceStyle = style as unknown as Record<string, string>;
  for (const prop of MIRRORED_PROPS) {
    mirrorStyle[prop] = sourceStyle[prop];
  }
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.style.height = 'auto';
  mirror.style.overflow = 'hidden';
  // textareas soft-wrap; the mirror must too
  mirror.style.whiteSpace = 'pre-wrap';

  mirror.textContent = value.slice(0, start);
  const span = document.createElement('span');
  span.textContent = value.slice(start, end) || '.';
  mirror.appendChild(span);
  // trailing text keeps the last line's wrapping honest
  mirror.appendChild(document.createTextNode(value.slice(end)));

  document.body.appendChild(mirror);
  const spanTop = span.offsetTop;
  const spanLeft = span.offsetLeft;
  const lineHeight = span.offsetHeight > 0 ? Math.min(span.offsetHeight, parseFloat(style.lineHeight) || 24) : 24;
  document.body.removeChild(mirror);

  return {
    top: spanTop - textarea.scrollTop,
    left: spanLeft - textarea.scrollLeft,
    height: lineHeight,
  };
}
