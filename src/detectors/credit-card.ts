import type { Detector, Finding } from '../types/index.js';

// Candidate card numbers. BIN ranges follow published issuer prefixes.
// Luhn is the gate, so broader BINs are safe: a non-card run fails checksum.
const CARD_PATTERNS: RegExp[] = [
  // 16-digit cards with optional 19-digit tail: Visa, Mastercard 51-55 and
  // 2221-2720, Discover, JCB 3528-3589, UnionPay 62/81, Maestro 50/56-69/6x,
  // Diners 30/36/38/39 in 16-digit form. Separators are space or hyphen only.
  /(?<![0-9A-Za-z])(?:4[0-9]{3}|5[1-5][0-9]{2}|222[1-9]|22[3-9][0-9]|2[3-6][0-9]{2}|27[01][0-9]|2720|6011|65[0-9]{2}|64[4-9][0-9]|35[2-8][0-9]|62[0-9]{2}|81[0-9]{2}|50[0-9]{2}|5[6-9][0-9]{2}|6[0-9]{3}|30[0-5][0-9]|36[0-9]{2}|38[0-9]{2}|39[0-9]{2})[ -]?[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{4}(?:[ -]?[0-9]{3})?(?![0-9A-Za-z])/g,
  // 15-digit American Express: 4-6-5 format with spaces, hyphens, or continuous
  /(?<![0-9A-Za-z])(?:34|37)[0-9]{2}[ -]?[0-9]{6}[ -]?[0-9]{5}(?![0-9A-Za-z])/g,
  // 14-digit Diners Club: 4-6-4 format with spaces, hyphens, or continuous
  /(?<![0-9A-Za-z])(?:30[0-5][0-9]|36[0-9]{2}|38[0-9]{2}|39[0-9]{2})[ -]?[0-9]{6}[ -]?[0-9]{4}(?![0-9A-Za-z])/g,
];

// A number that passes Luhn is almost never anything else.
const CARD_CONFIDENCE = 0.95;

// A separated 3-digit tail that does not belong to the card: `4111 1111 1111 1111 123`.
const SEPARATED_TAIL = /[ -][0-9]{3}$/;

/**
 * Validates a credit card number using the Luhn (Mod-10) algorithm.
 */
function isValidLuhn(numberStr: string): boolean {
  const digits = numberStr.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) {
    return false;
  }

  let sum = 0;
  let shouldDouble = false;

  // Process digits from right to left
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = parseInt(digits.charAt(i), 10);
    if (Number.isNaN(digit)) return false;

    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }

    sum += digit;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}

export class CreditCardDetector implements Detector {
  readonly name = 'CreditCardDetector';

  detect(text: string): Finding[] {
    const raw: Finding[] = [];

    for (const regex of CARD_PATTERNS) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = regex.exec(text)) !== null) {
        let value = match[0];

        // The optional 19-digit tail is taken greedily, so a 16-digit card followed by a
        // separate 3-digit number (a CVV, a count) fails Luhn as a whole. Try it without.
        if (!isValidLuhn(value) && SEPARATED_TAIL.test(value)) {
          value = value.slice(0, -4);
        }

        if (isValidLuhn(value)) {
          raw.push({
            category: 'CreditCard',
            span: [match.index, match.index + value.length],
            value,
            placeholderPrefix: 'CreditCard',
            confidence: CARD_CONFIDENCE,
            method: 'checksum',
          });
        }
      }
    }

    return raw.sort((a, b) => a.span[0] - b.span[0]);
  }
}
