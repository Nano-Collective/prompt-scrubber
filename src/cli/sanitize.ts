/** Strip C0, DEL, C1, and CSI so rendered output cannot hide content. Keeps tab. */
export function sanitizeLine(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 27) {
      if (text[i + 1] === '[') i = skipCsi(text, i + 2);
      continue;
    }
    if (code === 0x9b) {
      i = skipCsi(text, i + 1);
      continue;
    }
    if (code === 9 || (code >= 32 && code < 127) || code > 0x9f) out += text[i];
  }
  return out;
}

function skipCsi(text: string, i: number): number {
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c >= 0x40 && c <= 0x7e) return i;
    if (c < 0x20 || c > 0x3f) return i - 1;
    i++;
  }
  return i;
}
