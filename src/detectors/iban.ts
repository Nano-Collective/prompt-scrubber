import type { Detector, Finding } from '../types/index.js';

// Matches candidate IBANs (2 uppercase letters + 2 digits + alphanumeric characters up to 34 chars)
const IBAN_REGEX =
  /(?<![a-zA-Z0-9])([A-Z]{2}[0-9]{2}(?:[ ]?[0-9A-Z]{4}){2,7}(?:[ ]?[0-9A-Z]{1,4})?|[A-Z]{2}[0-9]{2}[0-9A-Z]{11,30})(?![ ]?[0-9A-Z])/g;

// Registry of IBAN-issuing countries and their fixed total length (ISO 13616).
// MOD-97 alone accepts ~1.1% of random 22-char uppercase tokens; gating on a known
// country code and its exact length cuts that by roughly an order of magnitude.
const IBAN_LENGTHS = new Map(
  `AD24 AE23 AL28 AT20 AZ28 BA20 BE16 BG22 BH22 BI27 BR29 BY28 CH21 CR22 CY28 CZ24
   DE22 DJ27 DK18 DO28 EE20 EG29 ES24 FI18 FO18 FR27 GB22 GE22 GI23 GL18 GR27 GT28
   HN28 HR21 HU28 IE22 IL23 IQ23 IS26 IT27 JO30 KW30 KZ20 LB28 LC32 LI21 LT20 LU20
   LV21 LY25 MA28 MC27 MD24 ME22 MK19 MN20 MR27 MT31 MU30 NI28 NL18 NO15 OM23 PK24
   PL28 PS29 PT25 QA29 RO24 RS22 RU33 SA24 SC31 SD18 SE24 SI19 SK24 SM27 SO23 ST25
   SV28 TL23 TN24 TR26 UA29 VA22 VG24 XK20 YE30`
    .split(/\s+/)
    .map((entry) => [entry.slice(0, 2), Number(entry.slice(2))] as const),
);

/**
 * Validates an IBAN against its country's registered length, then the MOD-97
 * checksum algorithm (ISO/IEC 7064).
 */
function isValidIban(ibanStr: string): boolean {
  const cleaned = ibanStr.replace(/\s+/g, '').toUpperCase();
  if (cleaned.length !== IBAN_LENGTHS.get(cleaned.slice(0, 2))) {
    return false;
  }

  // Rearrange: Move first 4 characters (country code + check digits) to the end
  const rearranged = cleaned.slice(4) + cleaned.slice(0, 4);

  // Convert letters A-Z to numbers 10-35
  const numericStr = rearranged.replace(/[A-Z]/g, (char) => (char.charCodeAt(0) - 55).toString());

  try {
    return BigInt(numericStr) % 97n === 1n;
  } catch {
    return false;
  }
}

export class IbanDetector implements Detector {
  readonly name = 'IbanDetector';

  detect(text: string): Finding[] {
    const findings: Finding[] = [];
    IBAN_REGEX.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = IBAN_REGEX.exec(text)) !== null) {
      const value = match[0];
      if (!isValidIban(value)) {
        continue;
      }

      findings.push({
        category: 'Iban',
        span: [match.index, match.index + value.length],
        value,
        placeholderPrefix: 'Iban',
      });
    }

    return findings;
  }
}
