import type { Detector, Finding } from '../types/index.js';

// Matches IPv4 addresses with strict 0-255 octet bounds.
// Negative lookaround ensures we do not match 5+ segment versions (e.g. 1.2.3.4.5)
// while still allowing sentence-ending periods (e.g. "IP is 10.0.0.1.").
// An optional CIDR suffix is absorbed so 192.168.1.1/24 does not leave a dangling mask.
const IPV4_REGEX =
  /(?<![0-9]\.)(?<![0-9])\b(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\b(?:\/(?:3[0-2]|[12]?[0-9]))?(?!\.[0-9])(?![0-9])/g;

// Matches full (8 groups) and compressed (::) IPv6 addresses (RFC 4291 / RFC 5952).
// Negative lookaround ensures no trailing/leading alphanumeric or colon fragments.
const IPV6_REGEX =
  /(?<![a-zA-Z0-9:])(?:(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,7}:|:(?::[0-9a-fA-F]{1,4}){1,7}|(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}|(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}|(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}|(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}|::1)(?![a-zA-Z0-9:])/g;

export class IpAddressDetector implements Detector {
  readonly name = 'IpAddressDetector';

  detect(text: string): Finding[] {
    const raw: Finding[] = [];

    // 1. Scan for IPv4 matches
    IPV4_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = IPV4_REGEX.exec(text)) !== null) {
      const value = match[0];
      raw.push({
        category: 'IpAddress',
        span: [match.index, match.index + value.length],
        value,
        placeholderPrefix: 'IpAddress',
      });
    }

    // 2. Scan for IPv6 matches
    IPV6_REGEX.lastIndex = 0;
    while ((match = IPV6_REGEX.exec(text)) !== null) {
      const value = match[0];

      raw.push({
        category: 'IpAddress',
        span: [match.index, match.index + value.length],
        value,
        placeholderPrefix: 'IpAddress',
      });
    }

    // Sort findings by start offset ascending
    return raw.sort((a, b) => a.span[0] - b.span[0]);
  }
}
