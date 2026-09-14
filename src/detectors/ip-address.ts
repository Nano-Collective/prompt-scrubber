import type { Detector, Finding } from '../types/index.js';

// Shared IPv4 shape, with strict 0-255 octet bounds. The IPv4-mapped IPv6 forms embed
// the same shape, so both regexes are built from this to stop the two drifting apart.
const V4_OCTET = String.raw`(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])`;
const V4_ADDRESS = String.raw`(?:${V4_OCTET}\.){3}${V4_OCTET}`;
const HEX_GROUP = String.raw`[0-9a-fA-F]{1,4}`;

// Matches IPv4 addresses.
// Negative lookaround ensures we do not match 5+ segment versions (e.g. 1.2.3.4.5)
// while still allowing sentence-ending periods (e.g. "IP is 10.0.0.1.").
// An optional CIDR suffix is absorbed so 192.168.1.1/24 does not leave a dangling mask.
const IPV4_REGEX = new RegExp(
  String.raw`(?<![0-9]\.)(?<![0-9])\b${V4_ADDRESS}\b(?:\/(?:3[0-2]|[12]?[0-9]))?(?!\.[0-9])(?![0-9])`,
  'g',
);

// IPv4-mapped and IPv4-compatible IPv6 forms (RFC 4291 2.5.5). nginx, Java's
// InetAddress, and Docker all emit these for dual-stack client IPs, so they turn up
// in the logs users paste. They are listed first because JS alternation is
// leftmost-first rather than longest-match: behind the hex-only branches,
// `::ffff:192.0.2.1` matches only `::ffff:192` and leaks `.0.2.1` into the output.
const IPV6_V4_BRANCHES = [
  String.raw`(?:${HEX_GROUP}:){6}${V4_ADDRESS}`,
  String.raw`(?:${HEX_GROUP}:){1,5}:${V4_ADDRESS}`,
  String.raw`::(?:${HEX_GROUP}:)?${V4_ADDRESS}`,
];

// Hex-only IPv6 forms, full (8 groups) and compressed (::) (RFC 4291 / RFC 5952).
const IPV6_HEX_BRANCHES = [
  String.raw`(?:${HEX_GROUP}:){7}${HEX_GROUP}`,
  String.raw`(?:${HEX_GROUP}:){1,7}:`,
  String.raw`:(?::${HEX_GROUP}){1,7}`,
  String.raw`(?:${HEX_GROUP}:){1,6}:${HEX_GROUP}`,
  String.raw`(?:${HEX_GROUP}:){1,5}(?::${HEX_GROUP}){1,2}`,
  String.raw`(?:${HEX_GROUP}:){1,4}(?::${HEX_GROUP}){1,3}`,
  String.raw`(?:${HEX_GROUP}:){1,3}(?::${HEX_GROUP}){1,4}`,
  String.raw`(?:${HEX_GROUP}:){1,2}(?::${HEX_GROUP}){1,5}`,
  String.raw`${HEX_GROUP}:(?::${HEX_GROUP}){1,6}`,
  String.raw`::1`,
];

// Negative lookaround ensures no trailing/leading alphanumeric or colon fragments,
// and that an embedded IPv4 tail is not cut short mid-octet.
const IPV6_REGEX = new RegExp(
  String.raw`(?<![a-zA-Z0-9:.])(?:${[...IPV6_V4_BRANCHES, ...IPV6_HEX_BRANCHES].join('|')})(?![a-zA-Z0-9:])(?!\.[0-9])`,
  'g',
);

export class IpAddressDetector implements Detector {
  readonly name = 'IpAddressDetector';

  detect(text: string): Finding[] {
    const raw: Finding[] = [];

    // IPv6 first, so its IPv4-mapped forms claim their embedded IPv4 tail before the
    // IPv4 scan reaches it. Letting the two overlap would hand the decision to
    // resolveCollisions, whose span-length tie-break can keep the partial address.
    IPV6_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = IPV6_REGEX.exec(text)) !== null) {
      const value = match[0];
      raw.push({
        category: 'IpAddress',
        span: [match.index, match.index + value.length],
        value,
        placeholderPrefix: 'IpAddress',
      });
    }

    IPV4_REGEX.lastIndex = 0;
    while ((match = IPV4_REGEX.exec(text)) !== null) {
      const value = match[0];
      const start = match.index;
      // Skip if already covered by an IPv4-mapped IPv6 match
      const alreadyCovered = raw.some(
        (existing) => start >= existing.span[0] && start < existing.span[1],
      );
      if (alreadyCovered) {
        continue;
      }

      raw.push({
        category: 'IpAddress',
        span: [start, start + value.length],
        value,
        placeholderPrefix: 'IpAddress',
      });
    }

    // Sort findings by start offset ascending
    return raw.sort((a, b) => a.span[0] - b.span[0]);
  }
}
