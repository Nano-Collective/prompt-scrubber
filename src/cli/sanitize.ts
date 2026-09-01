/** Strip C0, DEL, and ESC sequences so rendered output cannot hide content. Keeps tab. */
export function sanitizeLine(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 27) {
      if (text[i + 1] === '[') {
        i += 2;
        // CSI: parameter bytes 0x30-0x3F, intermediates 0x20-0x2F, terminated by 0x40-0x7E
        while (i < text.length) {
          const c = text.charCodeAt(i);
          if (c >= 0x40 && c <= 0x7e) break; // final byte; the for-loop's i++ consumes it
          if (c < 0x20 || c > 0x3f) {
            i--;
            break;
          }
          i++;
        }
      } else if (text[i + 1] === ']') {
        i += 2;
        while (i < text.length) {
          const c = text.charCodeAt(i);
          if (c === 7) break;
          if (c === 27 && text[i + 1] === '\\') {
            i++;
            break;
          }
          i++;
        }
      }
      continue;
    }
    if (code === 9 || (code >= 32 && code !== 127)) out += text[i];
  }
  return out;
}
