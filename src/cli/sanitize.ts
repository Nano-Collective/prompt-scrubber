/** Drop C0 controls and ESC/CSI so rendered output cannot clear the screen or break colour. Keeps tab. */
export function sanitizeLine(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 27) {
      if (text[i + 1] === '[') {
        i += 2;
        while (i < text.length && !/[A-Za-z@]/.test(text[i]!)) i++;
      }
      continue;
    }
    if (code === 9 || code >= 32) out += text[i];
  }
  return out;
}
